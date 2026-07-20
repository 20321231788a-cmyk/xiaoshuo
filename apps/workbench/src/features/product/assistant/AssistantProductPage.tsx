import {
  FileText,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  X
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationSummary } from "@xiaoshuo/shared";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";
import { RichText } from "../../../components/RichText.js";
import { describePendingGeneratedTarget } from "../../../lib/workflow.js";
import { AssistantComposer } from "./AssistantComposer.js";
import { formatAssistantAttachmentSize } from "./assistantComposerUtils.js";

const CardDrawFeaturePage = lazy(() =>
  import("../../card-draw/CardDrawFeaturePage.js").then((module) => ({ default: module.CardDrawFeaturePage }))
);

export function AssistantProductPage({ controller }: { controller: WorkbenchController }) {
  const [mode, setMode] = useState<"chat" | "draw">("chat");
  const [searchQuery, setSearchQuery] = useState("");
  const [conversationMenuOpen, setConversationMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
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
  }, [conversationDetail?.id, messages.length, lastMessage?.id, lastMessage?.content.length]);

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

  function openConversationMenu() {
    setRenameDraft(conversationDetail?.title || "");
    setConfirmDelete(false);
    setConversationMenuOpen((value) => !value);
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
              <div>
                <strong>{conversationDetail?.title || "自由会话"}</strong>
                <span>自动保存</span>
              </div>
              <button className="icon-button subtle" type="button" aria-label="会话操作" aria-expanded={conversationMenuOpen} onClick={openConversationMenu}>
                <MoreHorizontal size={16} />
              </button>
              {conversationMenuOpen && (
                <div className="conversation-menu">
                  <input value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} aria-label="会话标题" />
                  <button type="button" onClick={() => { void controller.updateConversationTitle(renameDraft); setConversationMenuOpen(false); }}>保存标题</button>
                  <button type="button" onClick={() => { void controller.summarizeConversation(true); setConversationMenuOpen(false); }}>整理会话摘要</button>
                  <button
                    type="button"
                    className="danger"
                    disabled={!conversationDetail || busy}
                    onClick={() => {
                      if (!confirmDelete) {
                        setConfirmDelete(true);
                        return;
                      }
                      void controller.deleteConversation().then((deleted) => {
                        if (deleted) setConversationMenuOpen(false);
                      });
                    }}
                  >
                    {confirmDelete ? "再次点击确认删除" : "删除会话"}
                  </button>
                </div>
              )}
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
                  return (
                    <article className={`assistant-message ${userMessage ? "user" : "ai"}`} data-message-role={entry.role} key={entry.id}>
                      {!userMessage && <span className="assistant-message-avatar" aria-hidden="true"><Sparkles size={14} /></span>}
                      <div className="assistant-message-body">
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
            <p className="panel-note">AI 只会读取这里列出的内容。</p>
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
              {!conversationDetail?.pinned_context.length && !conversationDetail?.attachments.length && <p className="panel-note">固定当前文档或上传资料后会显示在这里。</p>}
            </div>

            <div className="context-scope" style={{ margin: "10px", borderTop: "1px solid var(--line)", paddingTop: "12px" }}>
              <ShieldCheck size={15} />
              <div>
                <strong>写入范围</strong>
                <span>只修改当前章节，提交前预览差异</span>
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
