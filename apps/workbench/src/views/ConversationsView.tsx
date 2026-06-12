import { ArrowUp, Copy, FilePlus2, MessageSquarePlus, Paperclip, Pencil, Pin, RefreshCw, Square, Trash2 } from "lucide-react";
import type { ConversationDetail, ConversationSummary } from "@xiaoshuo/shared";
import { useEffect, useState } from "react";
import { Panel } from "../components/Panel.js";
import { RichText } from "../components/RichText.js";
import type { OpenDocumentTab } from "../hooks/useWorkbenchController.js";
import { describeGeneratedSaveAction, describeGeneratedSaveReason, describeGeneratedWriteIntent, describePendingGeneratedTarget, pendingGeneratedTargetPaths } from "../lib/workflow.js";
import type { PendingGeneratedSave } from "../lib/workflow.js";

export function ConversationsView({
  conversations,
  activeConversationId,
  conversationDetail,
  busy,
  message,
  messageInput,
  sendingMessage,
  uploadingAttachment,
  activeDocumentPath,
  activeDocument,
  pendingGeneratedSave,
  onRefresh,
  onCreate,
  onSelect,
  onUpdateTitle,
  onSummarizeConversation,
  onPinCurrentDocument,
  onPinText,
  onRemovePinnedContext,
  onMessageInputChange,
  onUploadAttachment,
  onDeleteAttachment,
  onSendMessage,
  onStopMessage,
  onSavePendingGenerated,
  onSavePendingGeneratedAsDraft,
  onCopyPendingGeneratedContent,
  onDiscardPendingGenerated
}: {
  conversations: ConversationSummary[];
  activeConversationId: string;
  conversationDetail: ConversationDetail | null;
  busy: boolean;
  message: string;
  messageInput: string;
  sendingMessage: boolean;
  uploadingAttachment: boolean;
  activeDocumentPath: string;
  activeDocument: OpenDocumentTab | null;
  pendingGeneratedSave: PendingGeneratedSave | null;
  onRefresh: () => void;
  onCreate: () => void;
  onSelect: (conversationId: string) => void;
  onUpdateTitle: (title: string) => void;
  onSummarizeConversation: (useModel?: boolean) => void;
  onPinCurrentDocument: () => void;
  onPinText: (content: string) => void;
  onRemovePinnedContext: (itemId: string) => void;
  onMessageInputChange: (value: string) => void;
  onUploadAttachment: (file: File | null) => void;
  onDeleteAttachment: (attachmentId: string) => void;
  onSendMessage: () => void;
  onStopMessage: () => void;
  onSavePendingGenerated: (mode: "replace" | "append") => void;
  onSavePendingGeneratedAsDraft: () => void;
  onCopyPendingGeneratedContent: () => void;
  onDiscardPendingGenerated: () => void;
}) {
  const pendingTargetPaths = pendingGeneratedSave ? pendingGeneratedTargetPaths(pendingGeneratedSave) : [];
  const activeDocumentExcerptChars = activeDocument?.content.trim() ? Math.min(activeDocument.content.trim().length, 6000) : 0;
  const attachmentCount = conversationDetail?.attachments.length || 0;
  const [titleDraft, setTitleDraft] = useState(conversationDetail?.title || "");
  const [pinnedTextDraft, setPinnedTextDraft] = useState("");
  const [confirmDiscardGenerated, setConfirmDiscardGenerated] = useState(false);
  const pendingMessageId =
    pendingGeneratedSave?.source === "chat"
      ? [...(conversationDetail?.messages || [])].reverse().find((entry) => entry.role === "assistant")?.id || ""
      : "";

  useEffect(() => {
    setTitleDraft(conversationDetail?.title || "");
    setPinnedTextDraft("");
  }, [conversationDetail?.id, conversationDetail?.title]);

  function submitTitle() {
    const title = titleDraft.trim();
    if (title && title !== conversationDetail?.title) {
      onUpdateTitle(title);
    }
  }

  function submitPinnedText() {
    const text = pinnedTextDraft.trim();
    if (!text) {
      return;
    }
    onPinText(text);
    setPinnedTextDraft("");
  }

  return (
    <div className="double-grid">
      <Panel
        eyebrow="Conversations"
        title="会话列表"
        aside={
          <div className="action-pair">
            <button className="ghost-button" onClick={onRefresh}>
              <RefreshCw size={15} />
              <span>刷新</span>
            </button>
            <button className="refresh-button" onClick={onCreate} disabled={busy}>
              <MessageSquarePlus size={15} />
              <span>新建</span>
            </button>
          </div>
        }
      >
        <div className="conversation-list">
          {conversations.map((item) => (
            <button
              key={item.id}
              className={`conversation-card ${item.id === activeConversationId ? "active" : ""}`}
              onClick={() => onSelect(item.id)}
            >
              <strong>{item.title || "未命名对话"}</strong>
              <p>{item.current_skill || "未绑定技能"}</p>
              <span>{item.message_count} 条消息 / {item.attachment_count} 个附件</span>
            </button>
          ))}
          {!conversations.length && <p className="empty-copy">还没有会话，先新建一条，让 ArcWriter 记住这次写作目标。</p>}
        </div>
      </Panel>

      <Panel eyebrow="Details" title="会话详情">
        <div className="detail-stack">
          {!conversationDetail && <p className="empty-copy">现在可以直接在下面发消息，没有现成会话时，ArcWriter 会先帮你创建一条。</p>}
          {conversationDetail && (
            <>
              <div className="status-banner">
                <div className="conversation-title-row">
                  <label className="field compact-field conversation-title-field">
                    <span>会话标题</span>
                    <input
                      value={titleDraft}
                      onChange={(event) => setTitleDraft(event.target.value)}
                      onBlur={submitTitle}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          submitTitle();
                          event.currentTarget.blur();
                        }
                      }}
                      disabled={busy}
                    />
                  </label>
                  <button className="ghost-button" onClick={submitTitle} disabled={busy || !titleDraft.trim() || titleDraft.trim() === conversationDetail.title}>
                    <Pencil size={15} />
                    <span>改名</span>
                  </button>
                </div>
                <p>{conversationDetail.summary || "这条会话还没有生成摘要。"}</p>
                <div className="action-pair">
                  <button className="ghost-button" onClick={() => onSummarizeConversation(false)} disabled={busy}>
                    <RefreshCw size={15} />
                    <span>刷新摘要</span>
                  </button>
                  <button className="ghost-button" onClick={() => onSummarizeConversation(true)} disabled={busy}>
                    <RefreshCw size={15} />
                    <span>用模型摘要</span>
                  </button>
                </div>
              </div>
              <div className="conversation-stats">
                <article>
                  <Pin size={15} />
                  <strong>{conversationDetail.pinned_context.length}</strong>
                  <span>固定上下文</span>
                </article>
                <article>
                  <Paperclip size={15} />
                  <strong>{conversationDetail.attachments.length}</strong>
                  <span>附件</span>
                </article>
              </div>
              <div className="pinned-context-panel">
                <div className="attachment-panel-head">
                  <strong>固定上下文</strong>
                  <button className="ghost-button" onClick={onPinCurrentDocument} disabled={busy || !activeDocumentPath}>
                    <FilePlus2 size={15} />
                    <span>固定当前文档</span>
                  </button>
                </div>
                <div className="pinned-compose">
                  <textarea
                    value={pinnedTextDraft}
                    onChange={(event) => setPinnedTextDraft(event.target.value)}
                    placeholder="粘贴一段想长期带入本会话的设定、约束或目标"
                    disabled={busy}
                  />
                  <button className="refresh-button" onClick={submitPinnedText} disabled={busy || !pinnedTextDraft.trim()}>
                    <Pin size={15} />
                    <span>固定文本</span>
                  </button>
                </div>
                {conversationDetail.pinned_context.length ? (
                  <div className="pinned-context-list">
                    {conversationDetail.pinned_context.map((item) => (
                      <article key={item.id} className="pinned-context-card">
                        <div>
                          <strong>{item.label || item.path || item.kind}</strong>
                          <p>{item.path || item.kind} · {item.created_at}</p>
                          <p>{item.content_excerpt}</p>
                        </div>
                        <button className="ghost-button" onClick={() => onRemovePinnedContext(item.id)} disabled={busy}>
                          <Trash2 size={15} />
                          <span>移除</span>
                        </button>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="empty-copy">当前会话没有固定上下文。固定文档或文本后，后续消息会稳定带入这些信息。</p>
                )}
              </div>
              <div className="attachment-panel">
                <div className="attachment-panel-head">
                  <strong>会话附件</strong>
                  <label className="ghost-button attachment-upload-button">
                    <Paperclip size={15} />
                    <span>{uploadingAttachment ? "上传中" : "上传附件"}</span>
                    <input
                      type="file"
                      disabled={busy || uploadingAttachment}
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0] || null;
                        onUploadAttachment(file);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                </div>
                {conversationDetail.attachments.length ? (
                  <div className="attachment-list">
                    {conversationDetail.attachments.map((attachment) => (
                      <article key={attachment.id} className="attachment-card">
                        <div>
                          <strong>{attachment.name}</strong>
                          <p>{attachment.excerpt || attachment.media_type}</p>
                        </div>
                        <button className="ghost-button" onClick={() => onDeleteAttachment(attachment.id)} disabled={busy}>
                          <span>移除</span>
                        </button>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="empty-copy">当前会话没有附件。本次发送不会额外带入附件文本。</p>
                )}
              </div>
            </>
          )}

          <div className="status-banner compact-banner">
            <strong>{message || "这里已经接上了流式聊天和响应回流。下一步的真实结果会从这里直接落进新工作台。"}</strong>
          </div>

          <div className="message-list conversation-thread">
            {conversationDetail?.messages.length ? (
              conversationDetail.messages.map((entry) => (
                <article key={entry.id} className={`message-card ${entry.role === "assistant" ? "assistant-card" : ""}`}>
                  <div className="message-head">
                    <strong>{entry.role}</strong>
                    <span>{entry.created_at}</span>
                  </div>
                  <RichText text={entry.content} />
                  <WebSearchSources metadata={entry.metadata} />
                  {pendingGeneratedSave && entry.id === pendingMessageId && (
                    <div className="generated-save-inline xw-generated-save-inline" data-testid="conversation-pending-save-panel">
                      <div className="generated-save-inline-copy">
                        <strong>{describePendingGeneratedTarget(pendingGeneratedSave)}</strong>
                        <span>
                          已生成约 {pendingGeneratedSave.cacheChars || pendingGeneratedSave.content.length} 字，默认
                          {pendingGeneratedSave.defaultMode === "append" ? "追加" : "覆盖"}。
                        </span>
                        <span>{describeGeneratedWriteIntent(pendingGeneratedSave)}</span>
                        {describeGeneratedSaveReason(pendingGeneratedSave) && <span>{describeGeneratedSaveReason(pendingGeneratedSave)}</span>}
                        {pendingTargetPaths.length > 1 && (
                          <span>{pendingTargetPaths.join(" / ")}</span>
                        )}
                      </div>
                      <div className="action-pair">
                        <button className="refresh-button compact" onClick={() => onSavePendingGenerated("replace")} disabled={busy}>
                          <span>{describeGeneratedSaveAction("replace", pendingGeneratedSave.defaultMode, pendingTargetPaths.length, pendingGeneratedSave.skillId)}</span>
                        </button>
                        <button className="ghost-button compact" onClick={() => onSavePendingGenerated("append")} disabled={busy}>
                          <span>{describeGeneratedSaveAction("append", pendingGeneratedSave.defaultMode, pendingTargetPaths.length, pendingGeneratedSave.skillId)}</span>
                        </button>
                        <button className="ghost-button compact" onClick={onSavePendingGeneratedAsDraft} disabled={busy}>
                          <FilePlus2 size={15} />
                          <span>另存草稿</span>
                        </button>
                        <button className="ghost-button compact" onClick={onCopyPendingGeneratedContent} disabled={busy}>
                          <Copy size={15} />
                          <span>复制全文</span>
                        </button>
                        <button
                          className={confirmDiscardGenerated ? "refresh-button compact" : "ghost-button compact"}
                          onClick={() => {
                            if (!confirmDiscardGenerated) {
                              setConfirmDiscardGenerated(true);
                              return;
                            }
                            setConfirmDiscardGenerated(false);
                            onDiscardPendingGenerated();
                          }}
                          disabled={busy}
                        >
                          <span>{confirmDiscardGenerated ? "确认丢弃" : "不保存"}</span>
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              ))
            ) : (
              <p className="empty-copy">还没有消息。发第一条试试看，新的流式链路会在这里实时显示。</p>
            )}
          </div>

          <div className="composer-shell">
            <div className="send-context-panel">
              <div>
                <span>当前文档</span>
                <strong>{activeDocumentPath || "未选择文档"}</strong>
                <p>
                  {activeDocumentExcerptChars
                    ? `本次会带入文档末尾约 ${activeDocumentExcerptChars} 字作为上下文。`
                    : "本次不会带入当前文档内容。"}
                </p>
              </div>
              <div>
                <span>会话附件</span>
                <strong>{attachmentCount} 个</strong>
                <p>{attachmentCount ? "本次会显式带入当前会话的全部附件摘录。" : "本次不会带入附件。"}</p>
              </div>
              <div>
                <span>固定上下文</span>
                <strong>{conversationDetail?.pinned_context.length || 0} 条</strong>
                <p>固定上下文由后端会话详情接入。</p>
              </div>
            </div>
            <textarea
              data-testid="conversation-message-input"
              className="composer-input"
              value={messageInput}
              onChange={(event) => onMessageInputChange(event.target.value)}
              placeholder="直接告诉 ArcWriter 要做什么，比如读当前文档、整理设定，或者继续这一章。"
              spellCheck={false}
            />
            <div className="composer-actions">
              <button className="ghost-button" onClick={onCreate} disabled={busy || sendingMessage}>
                <MessageSquarePlus size={15} />
                <span>空白会话</span>
              </button>
              {sendingMessage ? (
                <button data-testid="conversation-stop-button" className="refresh-button" onClick={onStopMessage}>
                  <Square size={15} />
                  <span>停止</span>
                </button>
              ) : (
                <button data-testid="conversation-send-button" className="refresh-button" onClick={onSendMessage} disabled={busy || !messageInput.trim()}>
                  <ArrowUp size={15} />
                  <span>发送</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function WebSearchSources({ metadata }: { metadata: Record<string, unknown> }) {
  const rawSources = Array.isArray(metadata.web_search_sources) ? metadata.web_search_sources : [];
  const sources = rawSources
    .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : null))
    .map((item) => ({
      title: String(item?.title || "").trim(),
      url: String(item?.url || "").trim()
    }))
    .filter((item) => item.title && /^https?:\/\//i.test(item.url))
    .slice(0, 5);

  if (!sources.length) {
    return null;
  }

  return (
    <div className="web-source-list">
      <span>联网来源</span>
      {sources.map((source) => (
        <a key={`${source.title}-${source.url}`} href={source.url} target="_blank" rel="noreferrer">
          {source.title}
        </a>
      ))}
    </div>
  );
}
