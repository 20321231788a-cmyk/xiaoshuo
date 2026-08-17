import { ArrowUp, Check, FileText, Paperclip, Plus, Square, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";
import { AssistantModelControls } from "./AssistantModelControls.js";
import { formatAssistantAttachmentSize, shouldSubmitAssistantMessage } from "./assistantComposerUtils.js";

const MIN_TEXTAREA_HEIGHT = 52;
const MAX_TEXTAREA_HEIGHT = 160;

export function AssistantComposer({ controller }: { controller: WorkbenchController }) {
  const [contextOpen, setContextOpen] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [visibleStatus, setVisibleStatus] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const contextRootRef = useRef<HTMLDivElement | null>(null);
  const contextTriggerRef = useRef<HTMLButtonElement | null>(null);
  const detail = controller.conversationDetail;
  const pinnedContext = detail?.pinned_context || [];
  const attachments = detail?.attachments || [];
  const contextCount = pinnedContext.length + attachments.length;
  const activeDocument = controller.openDocuments.find((item) => item.path === controller.activeDocumentPath) || null;
  const pendingReferences = controller.pendingReferenceResolution;
  const automaticReferenceCount = pendingReferences?.references.length || 0;
  const selectedReferenceCount = pendingReferences?.selectedPaths.length || 0;
  const actionBusy = controller.conversationBusy || controller.conversationModelPreferenceBusy;
  const sendLocked = actionBusy || controller.uploadingAttachment;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    const height = Math.min(MAX_TEXTAREA_HEIGHT, Math.max(MIN_TEXTAREA_HEIGHT, textarea.scrollHeight));
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }, [controller.messageInput]);

  useEffect(() => {
    if (!contextOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!contextRootRef.current?.contains(event.target as Node)) setContextOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setContextOpen(false);
      window.requestAnimationFrame(() => contextTriggerRef.current?.focus());
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextOpen]);

  useEffect(() => {
    const message = controller.conversationMessage.trim();
    if (!message) {
      setVisibleStatus("");
      return;
    }
    setVisibleStatus(message);
    const timer = window.setTimeout(() => setVisibleStatus(""), 3_000);
    return () => window.clearTimeout(timer);
  }, [controller.conversationMessage]);

  function send() {
    if ((!controller.messageInput.trim() && !attachments.length) || controller.sendingMessage || sendLocked) return;
    if (!controller.messageInput.trim() && attachments.length) {
      void controller.sendMessage("请阅读我刚添加的资料，并按其中内容继续协助我。");
      return;
    }
    void controller.sendMessage();
  }

  function uploadFiles(files: FileList | File[]) {
    if (!files.length || sendLocked) return;
    void controller.uploadConversationAttachment(files);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDraggingFiles(false);
    uploadFiles(event.dataTransfer.files);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = event.clipboardData.files;
    if (!files.length) return;
    event.preventDefault();
    uploadFiles(files);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!shouldSubmitAssistantMessage({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.nativeEvent.keyCode,
      value: controller.messageInput,
      locked: controller.sendingMessage || sendLocked
    })) return;
    event.preventDefault();
    send();
  }

  return (
    <div className="assistant-composer-wrap">
      <div
        className={`assistant-composer${draggingFiles ? " dragging-files" : ""}`}
        onDragEnter={(event) => {
          if (event.dataTransfer.types.includes("Files")) setDraggingFiles(true);
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDraggingFiles(false);
        }}
        onDrop={handleDrop}
      >
        {pendingReferences && (
          <section className="assistant-reference-confirm" aria-label="确认参考文件">
            <div className="assistant-reference-confirm-head">
              <div>
                <strong>确认参考文件</strong>
                <span>
                  {automaticReferenceCount ? `自动引用 ${automaticReferenceCount} 个` : "没有自动引用"}
                  {pendingReferences.candidates.length ? `，候选 ${pendingReferences.candidates.length} 个` : ""}
                </span>
              </div>
              <button
                className="assistant-composer-icon"
                type="button"
                title="取消本次发送"
                aria-label="取消参考文件确认"
                disabled={controller.sendingMessage || sendLocked}
                onClick={() => controller.discardPendingReferenceResolution()}
              >
                <X size={15} />
              </button>
            </div>

            {pendingReferences.references.length > 0 && (
              <div className="assistant-reference-list" aria-label="自动引用文件">
                {pendingReferences.references.map((candidate) => (
                  <span className="assistant-reference-chip automatic" key={candidate.path} title={`${candidate.reason} · ${candidate.path}`}>
                    <Check size={13} />
                    <span>{candidate.label || candidate.path}</span>
                  </span>
                ))}
              </div>
            )}

            <div className="assistant-reference-list" aria-label="候选参考文件">
              {pendingReferences.candidates.map((candidate) => {
                const selected = pendingReferences.selectedPaths.includes(candidate.path);
                return (
                  <label className={`assistant-reference-chip selectable${selected ? " selected" : ""}`} key={candidate.path} title={`${candidate.reason} · ${candidate.path}`}>
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={controller.sendingMessage || sendLocked}
                      onChange={() => controller.togglePendingReferenceCandidate(candidate.path)}
                    />
                    <span>{candidate.label || candidate.path}</span>
                    <small>{Math.round(candidate.confidence * 100)}%</small>
                  </label>
                );
              })}
            </div>

            {pendingReferences.warnings.length > 0 && (
              <p className="assistant-reference-warning">{pendingReferences.warnings.join("；")}</p>
            )}

            <div className="assistant-reference-actions">
              <button
                className="button primary compact"
                type="button"
                disabled={controller.sendingMessage || sendLocked || (!automaticReferenceCount && !selectedReferenceCount)}
                onClick={() => void controller.confirmPendingReferenceResolution()}
              >
                {selectedReferenceCount ? `引用 ${automaticReferenceCount + selectedReferenceCount} 个并发送` : "引用自动文件并发送"}
              </button>
              <button
                className="button secondary compact"
                type="button"
                disabled={controller.sendingMessage || sendLocked}
                onClick={() => void controller.sendPendingReferenceResolutionWithoutCandidates()}
              >
                不引用候选，直接发送
              </button>
            </div>
          </section>
        )}

        {attachments.length > 0 && (
          <div className="assistant-attachment-chips" aria-label="已附加资料">
            {attachments.map((item) => (
              <span className="assistant-attachment-chip" key={item.id} title={`${item.name} · ${formatAssistantAttachmentSize(item.size)}`}>
                <Paperclip size={13} />
                <span>{item.name}</span>
                <button type="button" aria-label={`移除附件${item.name}`} disabled={actionBusy} onClick={() => void controller.deleteConversationAttachment(item.id)}><X size={13} /></button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          aria-label="消息内容"
          value={controller.messageInput}
          onChange={(event) => controller.setMessageInput(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="继续提问，或描述你想要的修改……"
        />

        <div className="assistant-composer-toolbar">
          <div className="assistant-composer-tools">
            <button
              className="assistant-composer-icon"
              type="button"
              title="添加资料"
              aria-label="添加资料"
              disabled={controller.uploadingAttachment || controller.sendingMessage}
              onClick={() => attachmentInputRef.current?.click()}
            >
              <Plus size={17} />
            </button>
            <input
              ref={attachmentInputRef}
              type="file"
              multiple
              accept=".txt,.md,.markdown,.docx,.pdf,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              hidden
              onChange={(event) => {
                void controller.uploadConversationAttachment(event.target.files);
                event.currentTarget.value = "";
              }}
            />

            <div className="assistant-context-control" ref={contextRootRef}>
              <button
                ref={contextTriggerRef}
                className="assistant-context-trigger"
                type="button"
                aria-haspopup="dialog"
                aria-expanded={contextOpen}
                onClick={() => setContextOpen((value) => !value)}
              >
                <span>上下文 {contextCount} 项</span>
              </button>

              {contextOpen && (
                <div className="assistant-context-popover" role="dialog" aria-label="本次上下文">
                  <div className="assistant-context-popover-head">
                    <div>
                      <strong>本次上下文</strong>
                      <span>AI 只读取这里列出的资料</span>
                    </div>
                    <button
                      type="button"
                      disabled={!activeDocument || actionBusy}
                      onClick={() => void controller.pinCurrentDocumentToConversation()}
                    >
                      <Plus size={14} />固定当前文档
                    </button>
                  </div>

                  <div className="assistant-context-list">
                    {pinnedContext.map((item) => (
                      <div className="assistant-context-row" key={item.id}>
                        <FileText size={15} />
                        <div><strong>{item.label}</strong><small>{item.path || item.content_excerpt || "固定文本"}</small></div>
                        <button type="button" aria-label={`移除${item.label}`} disabled={actionBusy} onClick={() => void controller.removePinnedConversationContext(item.id)}><X size={14} /></button>
                      </div>
                    ))}
                    {attachments.map((item) => (
                      <div className="assistant-context-row" key={item.id}>
                        <Paperclip size={15} />
                        <div><strong>{item.name}</strong><small>{formatAssistantAttachmentSize(item.size)}</small></div>
                        <button type="button" aria-label={`删除附件${item.name}`} disabled={actionBusy} onClick={() => void controller.deleteConversationAttachment(item.id)}><X size={14} /></button>
                      </div>
                    ))}
                    {!contextCount && <p className="assistant-context-empty">尚未添加资料</p>}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="assistant-composer-status-slot">
            {visibleStatus && (
              <p className="assistant-composer-status" role="status" aria-live="polite" title={visibleStatus}>
                {visibleStatus}
              </p>
            )}
          </div>

          <div className="assistant-composer-actions">
            <AssistantModelControls controller={controller} />
            {controller.sendingMessage ? (
              <button className="assistant-send-button stop" type="button" title="停止生成" aria-label="停止生成" onClick={() => controller.stopMessage()}>
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button className="assistant-send-button" type="button" title="发送" aria-label="发送" onClick={send} disabled={(!controller.messageInput.trim() && !attachments.length) || sendLocked}>
                <ArrowUp size={17} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
