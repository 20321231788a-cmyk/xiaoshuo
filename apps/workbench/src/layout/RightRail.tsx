import type { AppConfig, ConversationSummary, JobInfo } from "@xiaoshuo/shared";
import {
  Activity,
  ArchiveRestore,
  Bot,
  BookOpen,
  FileText,
  History,
  Library,
  Link,
  MessageSquarePlus,
  Pin,
  ScanSearch,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  X,
  Wand2
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { WorkbenchController } from "../hooks/useWorkbenchController.js";
import { attachmentDisplayName } from "../lib/attachments.js";
import { buildRailStatusSummary } from "../lib/railStatus.js";

export type CenterFeature =
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

export const railModes = [
  { key: "ai", label: "AI", icon: Bot, tab: "editor", feature: "editor" },
  { key: "batch", label: "批量", icon: Wand2, tab: "operations", feature: "batch" },
  { key: "crawl", label: "拆书", icon: BookOpen, tab: "operations", feature: "crawl" },
  { key: "card_draw", label: "抽卡", icon: Sparkles, tab: "operations", feature: "card_draw" },
  { key: "ledger", label: "伏笔", icon: Pin, tab: "overview", feature: "ledger" },
  { key: "revision", label: "日志", icon: History, tab: "overview", feature: "revision" },
  { key: "traces", label: "运行", icon: Activity, tab: "overview", feature: "traces" },
  { key: "skills", label: "技能", icon: Library, tab: "operations", feature: "skills" },
  { key: "consistency", label: "一致性", icon: ScanSearch, tab: "operations", feature: "consistency" },
  { key: "settings", label: "设置", icon: Settings, tab: "config", feature: "settings" }
] as const;

export type RailMode = (typeof railModes)[number]["key"];

function webSearchTogglePatch(config: AppConfig, enabled: boolean): Partial<AppConfig> {
  return {
    web_search_enabled: enabled,
    ...(enabled && config.web_search_provider === "custom" && !config.web_search_base_url?.trim() ? { web_search_provider: "bing" as const } : {})
  };
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
  const summary = buildRailStatusSummary({
    selectedJobDetail: controller.selectedJobDetail,
    jobs: controller.snapshot?.jobs || [],
    operationsBusy: controller.operationsBusy,
    conversationBusy: controller.conversationBusy,
    sendingMessage: controller.sendingMessage,
    operationsMessage: controller.operationsMessage,
    conversationMessage: controller.conversationMessage,
    latestSkillResult: controller.latestSkillResult,
    pendingGeneratedSave: controller.pendingGeneratedSave,
    describeSkillId,
    statusLabel: crawlJobStatusLabel
  });

  if (!summary) {
    return null;
  }

  return (
    <article className="xw-rail-result" aria-live="polite">
      <div className="xw-crawl-progress-head">
        <strong>{summary.title}</strong>
        {summary.showProgress && !summary.indeterminate && <span>{summary.progressPercent}%</span>}
      </div>

      {summary.showProgress && (
        <div className={`xw-crawl-progress-track ${summary.indeterminate ? "xw-progress-indeterminate" : ""}`} aria-hidden="true">
          <span style={summary.indeterminate ? undefined : { width: `${summary.progressPercent}%` }} />
        </div>
      )}

      {summary.message && <p className="xw-rail-result-summary">{summary.message}</p>}

      {summary.hasPendingSave && (
        <div className="xw-rail-result-actions">
          <button className="xw-secondary-button compact" onClick={() => controller.savePendingGenerated("append")} disabled={controller.operationsBusy}>追加保存</button>
          <button className="xw-primary-button compact" onClick={() => controller.savePendingGenerated("replace")} disabled={controller.operationsBusy}>覆盖保存</button>
          <button className="xw-secondary-button compact" onClick={controller.copyPendingGeneratedContent} disabled={controller.operationsBusy}>复制</button>
          <button className="xw-danger-button compact" onClick={controller.discardPendingGenerated} disabled={controller.operationsBusy}>丢弃</button>
        </div>
      )}
    </article>
  );
}

function latestRunResultText(controller: WorkbenchController): string {
  return String(controller.pendingGeneratedSave?.content || controller.latestSkillResult?.result || controller.latestSkillResult?.content || "").trim();
}

export function GuardBanner({
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

export function AssistantRail({
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
  const composerAttachments = controller.conversationDetail?.attachments || [];
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
                multiple
                disabled={controller.uploadingAttachment || controller.conversationBusy}
                onChange={(event) => {
                  controller.uploadConversationAttachment(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            <button className="xw-secondary-button compact" onClick={() => controller.setMessageInput("")}>清空上下文</button>
          </div>
          <div className="composer-input-shell xw-ai-input-shell">
            {composerAttachments.length > 0 && (
              <div className="composer-attachment-strip xw-composer-attachment-strip" aria-label="本次发送附件">
                {composerAttachments.map((attachment) => (
                  <span key={attachment.id} className="composer-attachment-chip" title={attachment.name}>
                    <FileText size={14} />
                    <span>{attachmentDisplayName(attachment.name)}</span>
                    <button
                      type="button"
                      className="composer-attachment-remove"
                      onClick={() => controller.deleteConversationAttachment(attachment.id)}
                      disabled={controller.conversationBusy || controller.sendingMessage}
                      aria-label={`移除附件 ${attachment.name}`}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              className="xw-ai-input"
              value={controller.messageInput}
              onChange={(event) => controller.setMessageInput(event.target.value)}
              onKeyDown={handleAiInputKeyDown}
              placeholder="输入写作目标、修稿要求或拆书要求，系统会按内容自动调用合适的技能。"
              spellCheck={false}
            />
          </div>
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
