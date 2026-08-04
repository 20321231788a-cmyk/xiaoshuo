import {
  BookCheck,
  Check,
  FileText,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationSummary } from "@xiaoshuo/shared";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";
import type { UserFeature } from "../../../navigation.js";
import { RichText } from "../../../components/RichText.js";
import { describePendingGeneratedTarget } from "../../../lib/workflow.js";
import { AssistantComposer } from "./AssistantComposer.js";
import { formatAssistantAttachmentSize } from "./assistantComposerUtils.js";
import { automaticFeatures, saveAutomaticFeature } from "../tools/automaticFeatures.js";
import { runConsistencyReview } from "../review/reviewReports.js";
import { LibraryDraftReview } from "../shared/LibraryDraftReview.js";

const CardDrawFeaturePage = lazy(() =>
  import("../../card-draw/CardDrawFeaturePage.js").then((module) => ({ default: module.CardDrawFeaturePage }))
);

export function AssistantProductPage({ controller, onSelectFeature }: { controller: WorkbenchController; onSelectFeature: (feature: UserFeature) => void }) {
  const [mode, setMode] = useState<"chat" | "draw">("chat");
  const [searchQuery, setSearchQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renamingConversation, setRenamingConversation] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [automaticBusy, setAutomaticBusy] = useState(false);
  const [automaticMessage, setAutomaticMessage] = useState("");
  const [consistencyBusy, setConsistencyBusy] = useState(false);
  const [consistencySummary, setConsistencySummary] = useState<{ score: number | null; issueCount: number; saved: boolean; message: string } | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  const snapshot = controller.snapshot;
  if (!snapshot) return null;

  const conversations = snapshot.conversations || [];
  const activeConversationId = controller.conversationDetail?.id || controller.activeConversationSummary?.id || "";
  const conversationDetail = controller.conversationDetail;
  const busy = controller.conversationBusy || controller.conversationModelPreferenceBusy;
  const sendingMessage = controller.sendingMessage;
  const activeDocument = controller.openDocuments.find((item) => item.path === controller.activeDocumentPath) || null;

  const messages = conversationDetail?.messages || [];
  const lastMessage = messages.at(-1);

  // 滚动到底部
  useEffect(() => {
    if (messages.length) {
      const frame = window.requestAnimationFrame(() => {
        threadEndRef.current?.scrollIntoView({ block: "end" });
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [conversationDetail?.id, messages.length, lastMessage?.id, lastMessage?.content.length, lastMessage?.reasoning_content?.length]);

  // 会话搜索与按今天/昨天分组
  const groupedConversations = useMemo(() => {
    const filtered = conversations.filter(
      (c) =>
        c.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (c.current_skill || "").toLowerCase().includes(searchQuery.toLowerCase())
    );

    const today: ConversationSummary[] = [];
    const yesterday: ConversationSummary[] = [];
    const earlier: ConversationSummary[] = [];

    const now = new Date();
    const oneDay = 24 * 60 * 60 * 1000;

    for (const c of filtered) {
      const date = new Date(c.updated_at || Date.now());
      const diff = now.getTime() - date.getTime();
      if (diff < oneDay) {
        today.push(c);
      } else if (diff < 2 * oneDay) {
        yesterday.push(c);
      } else {
        earlier.push(c);
      }
    }

    return { today, yesterday, earlier };
  }, [conversations, searchQuery]);

  function beginConversationRename() {
    setRenameDraft(conversationDetail?.title || "");
    setConfirmDelete(false);
    setRenamingConversation(true);
  }

  useEffect(() => {
    setConfirmDelete(false);
    setRenamingConversation(false);
  }, [conversationDetail?.id]);

  async function saveConversationRename() {
    if (!renameDraft.trim()) return;
    await controller.updateConversationTitle(renameDraft);
    setRenamingConversation(false);
  }

  async function removeConversation() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    const deleted = await controller.deleteConversation();
    if (deleted) setConfirmDelete(false);
  }

  async function toggleAutomaticLore() {
    const config = controller.configDraft;
    const feature = automaticFeatures.find((item) => item.key === "auto_lore_extract_enabled");
    if (!config || !feature || automaticBusy) return;
    setAutomaticBusy(true);
    setAutomaticMessage("");
    try {
      const enabled = !Boolean(config.auto_lore_extract_enabled);
      const saved = await saveAutomaticFeature({
        feature,
        enabled,
        skills: controller.snapshot?.skills || [],
        setSkillEnabled: controller.setSkillEnabled,
        patchAndSaveConfig: controller.patchAndSaveConfig
      });
      setAutomaticMessage(saved ? `自动提取设定已${enabled ? "开启" : "关闭"}。` : "自动提取设定保存失败。");
    } finally {
      setAutomaticBusy(false);
    }
  }

  async function checkCurrentChapter() {
    if (!activeDocument || consistencyBusy) return;
    setConsistencyBusy(true);
    setConsistencySummary(null);
    try {
      const outcome = await runConsistencyReview({
        controller,
        scope: "chapter",
        sourcePath: activeDocument.path,
        text: activeDocument.content
      });
      if (!outcome) {
        setConsistencySummary({ score: null, issueCount: 0, saved: false, message: controller.operationsMessage || "一致性检查未返回可用结果。" });
        return;
      }
      setConsistencySummary({
        score: outcome.score,
        issueCount: outcome.issueCount,
        saved: Boolean(outcome.bundle),
        message: outcome.saveError ? "检查已完成，但报告保存失败。" : "检查完成，报告已保存。"
      });
    } finally {
      setConsistencyBusy(false);
    }
  }

  // 渲染助手或抽卡
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 顶栏控制分段 */}
      <div className="content-head" style={{ padding: "16px 20px 8px", marginBottom: 0, borderBottom: "1px solid var(--line)" }}>
        <div>
          <h1 style={{ fontSize: "16px" }}>AI 写作助手</h1>
          <p style={{ fontSize: "12px" }}>选择 AI 可读取的项目上下文；所有写入正文的结果均需经过预览确认。</p>
        </div>
        <div className="content-actions">
          <div className="segment">
            <button className={mode === "chat" ? "active" : ""} type="button" onClick={() => setMode("chat")}>对话</button>
            <button className={mode === "draw" ? "active" : ""} type="button" onClick={() => setMode("draw")}>抽卡</button>
          </div>
        </div>
      </div>

      {mode === "draw" ? (
        <div style={{ flex: 1, overflowY: "auto", padding: "20px" }}>
          <section className="aw-draw-page">
            <div className="aw-info-strip" style={{ display: "flex", gap: "10px", alignItems: "center", padding: "10px", background: "var(--accent-soft)", color: "var(--accent)", borderRadius: "6px", marginBottom: "15px", fontSize: "12px" }}>
              <Sparkles size={16} />
              <span>抽卡会生成多个候选版本。选择一版后再写入目标，未选版本保留在候选结果中。</span>
            </div>
            <Suspense fallback={<div style={{ padding: "20px", fontSize: "12px" }}>正在载入抽卡面板...</div>}>
              <CardDrawFeaturePage controller={controller} />
            </Suspense>
          </section>
        </div>
      ) : (
        <div className="assistant-page" style={{ flex: 1, minHeight: 0 }}>
          {/* 左栏：会话列表 */}
          <aside className="session-panel">
            <button className="button primary" style={{ width: "100%", minHeight: "30px" }} type="button" onClick={() => void controller.createConversation()}>
              <Plus size={15} />新建对话
            </button>
            <div className="session-search">
              <Search size={14} />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索会话..."
                style={{ border: 0, outline: 0, background: "transparent", width: "100%", fontSize: "12px" }}
              />
            </div>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {groupedConversations.today.length > 0 && (
                <>
                  <span className="subhead">今天</span>
                  {groupedConversations.today.map((item) => (
                    <button
                      key={item.id}
                      className={`session-row ${item.id === activeConversationId ? "active" : ""}`}
                      onClick={() => void controller.loadConversation(item.id)}
                    >
                      <MessageSquare size={14} />
                      <span>
                        <strong>{item.title || "未命名对话"}</strong>
                        <small>{item.current_skill || "自由对话"}</small>
                      </span>
                    </button>
                  ))}
                </>
              )}

              {groupedConversations.yesterday.length > 0 && (
                <>
                  <span className="subhead">昨天</span>
                  {groupedConversations.yesterday.map((item) => (
                    <button
                      key={item.id}
                      className={`session-row ${item.id === activeConversationId ? "active" : ""}`}
                      onClick={() => void controller.loadConversation(item.id)}
                    >
                      <MessageSquare size={14} />
                      <span>
                        <strong>{item.title || "未命名对话"}</strong>
                        <small>{item.current_skill || "自由对话"}</small>
                      </span>
                    </button>
                  ))}
                </>
              )}

              {groupedConversations.earlier.length > 0 && (
                <>
                  <span className="subhead">更早</span>
                  {groupedConversations.earlier.map((item) => (
                    <button
                      key={item.id}
                      className={`session-row ${item.id === activeConversationId ? "active" : ""}`}
                      onClick={() => void controller.loadConversation(item.id)}
                    >
                      <MessageSquare size={14} />
                      <span>
                        <strong>{item.title || "未命名对话"}</strong>
                        <small>{item.current_skill || "自由对话"}</small>
                      </span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </aside>

          {/* 中栏：对话区 */}
          <main className="chat-workspace">
            <div className="chat-title">
              <div className="chat-title-main">
                {renamingConversation ? (
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void saveConversationRename();
                      if (event.key === "Escape") setRenamingConversation(false);
                    }}
                    aria-label="会话标题"
                  />
                ) : (
                  <strong>{conversationDetail?.title || "自由会话"}</strong>
                )}
                <span>自动保存</span>
              </div>
              <div className="chat-title-actions">
                {renamingConversation ? (
                  <>
                    <button className="icon-button subtle" type="button" title="保存标题" aria-label="保存会话标题" disabled={busy || !renameDraft.trim()} onClick={() => void saveConversationRename()}>
                      <Check size={15} />
                    </button>
                    <button className="icon-button subtle" type="button" title="取消修改" aria-label="取消修改会话标题" disabled={busy} onClick={() => setRenamingConversation(false)}>
                      <X size={15} />
                    </button>
                  </>
                ) : (
                  <>
                    <button className="icon-button subtle" type="button" title="修改标题" aria-label="修改会话标题" disabled={!conversationDetail || busy} onClick={beginConversationRename}>
                      <Pencil size={15} />
                    </button>
                    <button className="icon-button subtle" type="button" title="整理会话摘要" aria-label="整理会话摘要" disabled={!conversationDetail || busy} onClick={() => void controller.summarizeConversation(true)}>
                      <FileText size={15} />
                    </button>
                    <button
                      className={`icon-button subtle danger${confirmDelete ? " confirming" : ""}`}
                      type="button"
                      title={confirmDelete ? "再次点击确认删除" : "删除会话"}
                      aria-label={confirmDelete ? "确认删除会话" : "删除会话"}
                      disabled={!conversationDetail || busy}
                      onClick={() => void removeConversation()}
                    >
                      <Trash2 size={15} />
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="chat-thread">
              <div className="assistant-thread-inner">
                {!messages.length && !sendingMessage && (
                  <div className="assistant-thread-empty">
                    <MessageSquare size={18} />
                    <span>开始新对话</span>
                  </div>
                )}

                {messages.map((entry) => {
                  if (entry.role === "system") {
                    return (
                      <article className="assistant-system-message" data-message-role="system" key={entry.id}>
                        <RichText text={entry.content} />
                      </article>
                    );
                  }
                  const userMessage = entry.role === "user";
                  const lastAssistantId = [...messages].reverse().find((message) => message.role === "assistant")?.id;
                  const isLastAssistant = entry.id === lastAssistantId;
                  const showReasoning = !userMessage && (
                    Boolean(entry.reasoning_content) ||
                    (isLastAssistant && !sendingMessage && controller.conversationModelPreferences.reasoning_enabled)
                  );
                  return (
                    <article className={`assistant-message ${userMessage ? "user" : "ai"}`} data-message-role={entry.role} key={entry.id}>
                      {!userMessage && <span className="assistant-message-avatar" aria-hidden="true"><Sparkles size={14} /></span>}
                      <div className="assistant-message-body">
                        {showReasoning && (
                          <details className="assistant-reasoning-content" open={Boolean(sendingMessage && isLastAssistant && entry.reasoning_content && !entry.content)}>
                            <summary>{sendingMessage && isLastAssistant ? (entry.content ? "思考完成" : "正在思考") : "思考过程"}</summary>
                            {entry.reasoning_content
                              ? <RichText text={entry.reasoning_content} />
                              : <p>当前模型本轮未返回可展示的思考内容。</p>}
                          </details>
                        )}
                        <RichText text={entry.content} />

                        {controller.pendingGeneratedSave && entry.id === [...messages].reverse().find((message) => message.role === "assistant")?.id && (
                          <div className="assistant-write-confirm">
                            <strong>{describePendingGeneratedTarget(controller.pendingGeneratedSave)}</strong>
                            <p>已生成约 {controller.pendingGeneratedSave.cacheChars || controller.pendingGeneratedSave.content.length} 字。</p>
                            <div className="assistant-write-actions">
                              <button className="button primary compact" type="button" onClick={() => void controller.savePendingGenerated("replace")} disabled={busy}>覆盖写入</button>
                              <button className="button secondary compact" type="button" onClick={() => void controller.savePendingGenerated("append")} disabled={busy}>追加写入</button>
                              <button className="button secondary compact" type="button" onClick={() => void controller.savePendingGeneratedAsDraft()} disabled={busy}>另存草稿</button>
                              <button className="button secondary compact" type="button" onClick={() => void controller.copyPendingGeneratedContent()} disabled={busy}>复制</button>
                              <button className="button secondary compact danger" type="button" onClick={() => controller.discardPendingGenerated()} disabled={busy}>丢弃</button>
                            </div>
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}

                <LibraryDraftReview
                  controller={controller}
                  domains={["lore", "style", "genre"]}
                  refreshKey={messages.length}
                  compact
                />

                {controller.pendingAgentConfirmations.map((confirmation) => (
                  <section className="assistant-agent-confirmation" aria-label="待确认操作" key={confirmation.confirmation_id}>
                    <div className="assistant-agent-confirmation-head">
                      <strong>{confirmation.summary || confirmation.action || "待确认操作"}</strong>
                      <span>{confirmation.risk_level} 风险 · 版本 {confirmation.version}</span>
                    </div>
                    {confirmation.target_paths.length > 0 && (
                      <p>目标：{confirmation.target_paths.join("、")}</p>
                    )}
                    {confirmation.action_payload && (
                      <details>
                        <summary>查看操作参数</summary>
                        <pre>{JSON.stringify(confirmation.action_payload, null, 2)}</pre>
                      </details>
                    )}
                    <div className="assistant-write-actions">
                      <button
                        className="button primary compact"
                        type="button"
                        disabled={Boolean(controller.pendingAgentConfirmationBusy)}
                        onClick={() => void controller.resolvePendingAgentConfirmation(confirmation, "approve")}
                      >
                        {controller.pendingAgentConfirmationBusy === confirmation.confirmation_id ? "正在批准..." : "批准并继续"}
                      </button>
                      <button
                        className="button secondary compact danger"
                        type="button"
                        disabled={Boolean(controller.pendingAgentConfirmationBusy)}
                        onClick={() => void controller.resolvePendingAgentConfirmation(confirmation, "reject")}
                      >
                        拒绝
                      </button>
                    </div>
                  </section>
                ))}

                {sendingMessage && !(lastMessage?.role === "assistant" && lastMessage.content.trim()) && (
                  <div className="assistant-message ai generating" data-message-role="assistant" role="status">
                    <span className="assistant-message-avatar" aria-hidden="true"><Sparkles size={14} /></span>
                    <div className="assistant-generating"><span />正在生成</div>
                  </div>
                )}
                <div ref={threadEndRef} />
              </div>
            </div>

            <AssistantComposer controller={controller} />
          </main>

          {/* 右栏：本次上下文栏 */}
          <aside className="context-panel">
            <div className="panel-head">
              <strong>本次上下文</strong>
              <button className="icon-button subtle" type="button" title="固定当前文档" aria-label="固定当前文档" onClick={() => void controller.pinCurrentDocumentToConversation()} disabled={!activeDocument || busy}><Plus size={15} /></button>
            </div>
            <p className="panel-note">AI 会自动读取项目大纲、设定、风格题材与近期正文；你还可以为本次会话补充文档和附件。</p>
            <div className="assistant-auto-context" aria-label="自动项目上下文">
              <strong>自动项目上下文</strong>
              <span>故事大纲（优先读取结构化大纲）</span>
              <span>人物与世界设定</span>
              <span>风格、题材与近期正文</span>
            </div>
            <div className="assistant-extra-context-title">本次额外上下文</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", padding: "10px" }}>
              {(conversationDetail?.pinned_context || []).map((item) => (
                <div className="context-item" key={item.id}>
                  <FileText size={15} />
                  <div><strong>{item.label}</strong><small>{item.path || item.content_excerpt || "固定文本"}</small></div>
                  <button type="button" aria-label={`移除${item.label}`} onClick={() => void controller.removePinnedConversationContext(item.id)}><X size={13} /></button>
                </div>
              ))}
              {(conversationDetail?.attachments || []).map((item) => (
                <div className="context-item" key={item.id}>
                  <Paperclip size={15} />
                  <div><strong>{item.name}</strong><small>{formatAssistantAttachmentSize(item.size)}</small></div>
                  <button type="button" aria-label={`删除附件${item.name}`} onClick={() => void controller.deleteConversationAttachment(item.id)}><X size={13} /></button>
                </div>
              ))}
              {!conversationDetail?.pinned_context.length && !conversationDetail?.attachments.length && <p className="panel-note">尚未补充额外上下文。固定当前文档或上传资料后会显示在这里。</p>}
            </div>

            <div className="context-scope" style={{ margin: "10px", borderTop: "1px solid var(--line)", paddingTop: "12px" }}>
              <ShieldCheck size={15} />
              <div>
                <strong>写入范围</strong>
                <span>只修改当前章节，提交前预览差异</span>
              </div>
            </div>

            <section className="context-assist-tools" aria-label="写作辅助">
              <div className="context-assist-heading">
                <strong>写作辅助</strong>
                <span>与写作设置保持同步</span>
              </div>
              <div className="context-assist-toggle-row">
                <div>
                  <strong>自动提取设定</strong>
                  <span>确认写入后送到待确认设定</span>
                </div>
                <button
                  className={`toggle${controller.configDraft?.auto_lore_extract_enabled ? " on" : ""}`}
                  type="button"
                  role="switch"
                  aria-checked={Boolean(controller.configDraft?.auto_lore_extract_enabled)}
                  aria-label={`${controller.configDraft?.auto_lore_extract_enabled ? "关闭" : "开启"}自动提取设定`}
                  disabled={automaticBusy || controller.configBusy}
                  onClick={() => void toggleAutomaticLore()}
                ><i /></button>
              </div>
              <button className="button secondary context-check-button" type="button" disabled={!activeDocument || consistencyBusy || controller.operationsBusy} onClick={() => void checkCurrentChapter()}>
                <BookCheck size={14} />{consistencyBusy ? "正在检查" : "检查当前章节"}
              </button>
              {!activeDocument && <p className="context-assist-note">先在正文编辑中打开一个章节。</p>}
              {(consistencyBusy || consistencySummary || automaticBusy || automaticMessage) && (
                <div className="context-assist-status" aria-live="polite">
                  {consistencyBusy ? (
                    <span>正在核对人物、设定、章纲与连续性...</span>
                  ) : consistencySummary ? (
                    <>
                      <strong>{consistencySummary.message}</strong>
                      {consistencySummary.score !== null && <span>得分 {consistencySummary.score}，发现 {consistencySummary.issueCount} 项建议。</span>}
                      {consistencySummary.saved && <button type="button" onClick={() => onSelectFeature("review")}>查看完整报告</button>}
                    </>
                  ) : (
                    <span>{automaticBusy ? "正在保存自动提取设定..." : automaticMessage}</span>
                  )}
                </div>
              )}
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}
